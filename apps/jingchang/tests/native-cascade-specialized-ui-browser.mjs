// Production presentation components, isolated synthetic receipts only.
import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const stage=path.resolve(process.env.SPECIALIZED_UI_ARTIFACTS||'artifacts/unified-integration-20261007-151410/specialized-ui-'+Date.now());await fs.mkdir(stage,{recursive:true});
const names=['native-cascade-ui.js','style.css','workflow-random.css','ark-credentials.css','jade-motion.css','cyan-glass.css'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),sources=new Map();
for(const name of names)sources.set('/'+name,await fs.readFile(path.join('public',name)));
const before=names.map(name=>({path:'public/'+name,sha256:hash(sources.get('/'+name))}));
await fs.writeFile(path.join(stage,'production-sha-start.json'),JSON.stringify(before,null,2));
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock · 列表与放大收据验收</title>
${names.filter(name=>name.endsWith('.css')).map(name=>'<link rel="stylesheet" href="/'+name+'">').join('')}
<style>main{padding:24px}h1{font-size:20px}.mock-banner{font-size:13px;margin:14px 0;line-height:1.6}#fixture-footer{flex-wrap:wrap;justify-content:flex-start}#fixture-footer button{font-size:12px}.dialog-head{align-items:flex-start}.dialog-head p{margin-top:8px}</style>
<main><h1>Mock 合成收据 · 隔离界面验收</h1><p class="mock-banner">使用生产组件与样式；未运行真实模型/GPU，390px仅浏览器尺寸模拟。</p></main>
<dialog id="fixture"><div class="dialog-head"><div><strong>Mock · <span id="view-label"></span></strong><p class="small muted">合成任务状态；不代表真实生成/GPU/手机验收</p></div></div>
<div class="dialog-body" id="receipt-scroll"><section id="batch-plan"></section><section id="batch-actual" hidden></section><section id="upscale-plan" hidden></section><section id="upscale-actual" hidden></section></div>
<div class="dialog-footer" id="fixture-footer"><button type="button" data-view="batch-plan">列表预检</button><button type="button" data-view="batch-actual">列表收据</button><button type="button" data-view="upscale-plan">放大预检</button><button type="button" data-view="upscale-actual">放大收据</button></div></dialog>
<script type="module">
import{nativeCascadePlanMarkup,nativeCascadeRequestMarkup}from'/native-cascade-ui.js';
const esc=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const evil=String.fromCharCode(60)+'img src=x onerror="window.mockXss=1">';
const list=Array.from({length:64},(_,index)=>'第 '+String(index+1).padStart(2,'0')+' 条固定文字 · 《计数》 / @原图 · '+evil+' & 尾部文字 · long-token='+('literalXYZ'.repeat(18)));
const refs=[{assetId:'mock-source-first',name:'首张图片 '+evil,kind:'image',identity:'a'.repeat(64)},{assetId:'mock-source-first',name:'同文件第二来源',kind:'image',identity:'b'.repeat(64)},{assetId:'mock-source-unused',name:'第二张保留图片',kind:'image',identity:'c'.repeat(64)}];
const batch={nodeId:'1',name:'text',values:list};
const summary={operations:2,generations:1,requests:64,sharedCopies:1};
document.querySelector('#batch-plan').innerHTML=nativeCascadePlanMarkup({summary,program:{},steps:[{title:'Mock 列表 '+evil,cascadeKind:'generate',count:64,promptBatch:batch},{title:'Mock 同级共享',cascadeKind:'copy',count:0}]},esc);
document.querySelector('#batch-actual').innerHTML=nativeCascadeRequestMarkup({actualInput:{prompt:'',displayPrompt:'',promptBatch:batch,providerRequestCount:64,referenceRefs:refs,unusedRefs:refs.slice(1)},childRequests:{count:64,submitted:3,completed:2,items:[{index:0,status:'completed',promptId:'mock-original-01'},{index:1,status:'completed',promptId:'mock-original-02'},{index:2,status:'pending',promptId:'mock-original-03'}]}},esc);
const enhancement={kind:'upscale',engine:'comfy',resolution:4096,maxResolution:4096,seedMode:'fixed',seed:5678};
document.querySelector('#upscale-plan').innerHTML=nativeCascadePlanMarkup({summary:{...summary,requests:1},program:{},steps:[{title:'Mock SeedVR2 '+evil,cascadeKind:'generate',count:1,imageEnhance:enhancement},{title:'Mock 同级共享',cascadeKind:'copy',count:0}]},esc);
document.querySelector('#upscale-actual').innerHTML=nativeCascadeRequestMarkup({actualInput:{prompt:'',displayPrompt:'',referenceRefs:refs,unusedRefs:refs.slice(1),enhancement:{...enhancement,sourceAssetId:refs[0].assetId,sourceIdentity:refs[0].identity}}},esc);
const labels={'batch-plan':'64 条固定列表预检','batch-actual':'已提交 3 / 64 的合成收据','upscale-plan':'SeedVR2 单图放大预检','upscale-actual':'SeedVR2 4K 合成收据'};
window.selectView=id=>{for(const section of document.querySelectorAll('#receipt-scroll>section'))section.hidden=section.id!==id;document.querySelector('#view-label').textContent=labels[id];document.querySelector('#receipt-scroll').scrollTop=0;if(!document.querySelector('#fixture').open)document.querySelector('#fixture').showModal();};
for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>window.selectView(button.dataset.view));
window.selectView('batch-plan');window.ready=true;
</script></html>`;
const server=http.createServer((req,res)=>{
 if(req.method!=='GET'){res.writeHead(405);return res.end();}
 if(req.url==='/'){res.setHeader('content-type','text/html');return res.end(html);}
 const bytes=sources.get(req.url);if(bytes){res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');return res.end(bytes);}
 res.writeHead(404);res.end();
});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
let browser;const errors=[],blocked=[],requests=[],checks=[];
try{
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({viewport:{width:1280,height:960},serviceWorkers:'block'});
 await context.route('**/*',route=>{const req=route.request();requests.push({url:req.url(),method:req.method()});
  if(new URL(req.url()).origin!==base||req.method()!=='GET'){blocked.push({url:req.url(),method:req.method()});return route.abort();}return route.continue();});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base);await page.waitForFunction(()=>window.ready);
 const choose=async id=>{await page.locator('[data-view="'+id+'"]').click();};
 const open=async selector=>{const item=page.locator(selector);await item.focus();await page.keyboard.press('Enter');};
 const fit=async()=>{assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert(await page.locator('#receipt-scroll').evaluate(e=>e.scrollWidth<=e.clientWidth+1));};
 const safe=async()=>{assert.equal(await page.locator('#receipt-scroll img,#receipt-scroll svg,#receipt-scroll script').count(),0);assert.equal(await page.evaluate(()=>window.mockXss),undefined);};
 const scrollBottom=async()=>{await page.locator('#receipt-scroll').hover();await page.mouse.wheel(0,100000);await page.waitForFunction(()=>{const e=document.querySelector('#receipt-scroll');return e.scrollTop>=e.scrollHeight-e.clientHeight-2;});};
 assert.match(await page.locator('.dialog-head').innerText(),/Mock[\s\S]*合成/);checks.push('visible-Mock-label-discloses-no-real-model-GPU-or-phone');
 assert.match(await page.locator('#batch-plan').innerText(),/最多 64 次生成请求/);await open('#batch-plan .native-cascade-batch>summary');
 assert.equal(await page.locator('#batch-plan .native-cascade-batch>ol>li').count(),64);assert.match(await page.locator('#batch-plan').innerText(),/第 64 条固定文字/);checks.push('preflight-renders-all-64-saved-literals-without-truncation');
 await safe();checks.push('production-plan-and-list-values-escape-markup');
 await choose('batch-actual');await open('#batch-actual>.native-cascade-request>summary');await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.activeElement.parentElement.className),'native-cascade-batch');await page.keyboard.press('Space');
 assert.equal(await page.locator('#batch-actual .native-cascade-batch').evaluate(e=>e.open),true);checks.push('keyboard-Enter-Tab-Space-opens-nested-real-details');
 const text=await page.locator('#batch-actual').innerText();assert.match(text,/已提交 3 \/ 64 次请求/);assert.match(text,/原编号 mock-original-01/);assert.match(text,/原编号 mock-original-03/);assert(!text.includes('mock-original-64'));checks.push('actual-receipt-shows-only-three-observed-upstream-IDs');
 assert.match(text,/《计数》 \/ @原图/);assert.equal(await page.locator('#batch-actual .native-cascade-batch>ol>li').count(),64);checks.push('literal-counter-and-source-markers-remain-unexpanded');
 await safe();await fit();await page.screenshot({path:path.join(stage,'01-mock-batch-desktop-top.png')});
 await scrollBottom();assert(await page.locator('#batch-actual .native-cascade-batch>ol>li').last().evaluate(e=>{const a=e.getBoundingClientRect(),b=document.querySelector('#receipt-scroll').getBoundingClientRect();return a.bottom>b.top&&a.top<b.bottom;}));
 assert.match(await page.locator('#batch-actual').innerText(),/本工作流未使用的引用：同文件第二来源、第二张保留图片/);checks.push('desktop-long-list-scroll-reaches-last-item-and-unused-refs');await page.screenshot({path:path.join(stage,'02-mock-batch-desktop-bottom.png')});
 await choose('upscale-plan');assert.match(await page.locator('#upscale-plan').innerText(),/单图放大 · 4K · 长边上限 4096 · 种子 5678/);assert.match(await page.locator('#upscale-plan').innerText(),/只处理有序引用里的第一张图片/);checks.push('SeedVR2-plan-shows-4K-cap-fixed-seed-and-first-image-rule');
 await choose('upscale-actual');await open('#upscale-actual>.native-cascade-request>summary');const upscale=await page.locator('#upscale-actual').innerText();
 assert.match(upscale,/单图放大 · 4K · 长边上限 4096/);assert.match(upscale,/来源 首张图片 <img.*（mock-source-first）/);assert.match(upscale,/同文件第二来源、第二张保留图片/);assert(!upscale.includes('强度 undefined'));checks.push('upscale-receipt-shows-resolution-first-source-and-unused-aliases');
 await safe();await fit();await page.screenshot({path:path.join(stage,'03-mock-upscale-desktop.png')});
 await page.setViewportSize({width:390,height:844});await choose('batch-actual');await fit();await page.locator('#batch-actual>.native-cascade-request>summary').focus();await page.keyboard.press('End');
 await page.waitForFunction(()=>document.querySelector('#receipt-scroll').scrollTop>0);checks.push('390px-keyboard-End-scrolls-long-production-dialog-content');
 await page.screenshot({path:path.join(stage,'04-mock-batch-390-bottom.png')});await choose('upscale-actual');await fit();assert.match(await page.locator('#upscale-actual').innerText(),/4K/);checks.push('390px-upscale-and-list-have-no-horizontal-overflow');await page.screenshot({path:path.join(stage,'05-mock-upscale-390.png')});
 const beforeReduced=await page.locator('#upscale-actual').innerText();await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>matchMedia('(prefers-reduced-motion:reduce)').matches));
 assert(await page.evaluate(()=>Array.from(document.querySelectorAll('button,summary')).every(e=>{const c=getComputedStyle(e);return c.animationName==='none'&&c.transitionDuration.split(',').every(value=>parseFloat(value)===0);})));assert.equal(await page.locator('#upscale-actual').innerText(),beforeReduced);checks.push('reduced-motion-disables-control-motion-without-changing-receipt-state');
 await page.locator('#upscale-actual>details>summary').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#upscale-actual>details').evaluate(e=>e.open),false);await page.keyboard.press('Enter');assert.equal(await page.locator('#upscale-actual>details').evaluate(e=>e.open),true);await fit();await safe();checks.push('reduced-motion-keeps-keyboard-receipt-open-close-working');await page.screenshot({path:path.join(stage,'06-mock-reduced-motion-390.png')});
 await page.keyboard.press('Escape');assert.equal(await page.locator('#fixture').evaluate(e=>e.open),false);checks.push('native-dialog-Escape-dismisses-keyboard-flow');
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert(requests.every(req=>req.method==='GET'&&new URL(req.url).origin===base));checks.push('only-isolated-GETs-no-page-errors-or-unexpected-network');
 const after=await Promise.all(names.map(async name=>({path:'public/'+name,sha256:hash(await fs.readFile(path.join('public',name)))})));await fs.writeFile(path.join(stage,'production-sha-end.json'),JSON.stringify(after,null,2));assert.deepEqual(after,before);checks.push('production-markup-and-five-styles-unchanged-during-test');
 const result={ok:true,evidenceKind:'mock_interaction',productionMarkup:true,checks,pageErrors:errors,blocked,requests,sourceUnchanged:true,realSecretReads:0,externalProviderRequests:0,formalWrites:0,formalServiceReloads:0,realGpuOrPhoneAcceptance:false};await fs.writeFile(path.join(stage,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:true,checkCount:checks.length,checks,stage}));
}catch(error){await fs.writeFile(path.join(stage,'failure.json'),JSON.stringify({ok:false,error:error.message,checks,pageErrors:errors,blocked,requests},null,2));throw error;}
finally{await browser?.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
