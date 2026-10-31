// Actual presentation code and CSS; all task data is synthetic and read-only.
import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const stage=path.resolve(process.env.MODELSCOPE_UI_ARTIFACTS||path.join(root,'artifacts','modelscope-ui-audit-'+Date.now()));
await fs.mkdir(stage,{recursive:true});
const names=['native-cascade-ui.js','native-modelscope-core.js','style.css','workflow-random.css','ark-credentials.css','jade-motion.css','cyan-glass.css'];
const hash=b=>createHash('sha256').update(b).digest('hex'),sources=new Map();
for(const name of names)sources.set('/'+name,await fs.readFile(path.join(root,'public',name)));
const sha=()=>names.map(name=>({path:'public/'+name,sha256:hash(sources.get('/'+name))}));
const before=sha();await fs.writeFile(path.join(stage,'source-start.json'),JSON.stringify(before,null,2));
for(const name of names)await fs.writeFile(path.join(stage,'source-'+name),sources.get('/'+name));
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock · ModelScope 收据验收</title>
${names.filter(n=>n.endsWith('.css')).map(n=>'<link rel="stylesheet" href="/'+n+'">').join('')}
<style>main{padding:24px}h1{font-size:20px}main p{margin-top:12px;line-height:1.6}.dialog-footer{flex-wrap:wrap}.dialog-head p{margin-top:8px}</style>
<main><h1>Mock 合成任务 · 隔离界面检查</h1><p>生产组件及样式；没有真实模型调用或正式工程操作，390px为浏览器模拟。</p><button id="reopen">重新查看收据</button></main>
<dialog id="fixture"><div class="dialog-head"><div><strong>Mock · ModelScope 独立请求收据</strong><p class="small muted">合成状态；未进行云生成/GPU/实体手机验收</p></div></div><div class="dialog-body" id="receipt-scroll"><section id="plan"></section><section id="actual" hidden></section><section id="single" hidden></section></div><div class="dialog-footer"><button data-view="plan">1–8份预检</button><button data-view="actual">8份实际收据</button><button data-view="single">单份文生图</button></div></dialog>
<script type="module">
import{nativeCascadePlanMarkup,nativeCascadeRequestMarkup}from'/native-cascade-ui.js';
import{studioRequestCount,studioModelscopeReferenceLimit}from'/native-modelscope-core.js';
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const evil=String.fromCharCode(60)+'img src=x onerror="window.mockXss=1">';
const marker={version:1,modelKey:'custom',acceptsImages:true};
const refs=Array.from({length:20},(_,i)=>({assetId:'mock-ref-'+i,name:'图片'+i+'_'+('long-source-name'.repeat(18))+' '+evil,kind:'image',identity:String(i).padStart(64,'0')}));
const items=Array.from({length:8},(_,i)=>({index:i,status:i<2?'completed':i<6?'pending':i===6?'failed':'unsubmitted',...(i<6?{upstreamId:'mock-original-'+i+'-'+('id'.repeat(45))}:{} )}));
const actual={actualInput:{prompt:'原提示文字 '+evil,displayPrompt:'原提示文字 '+evil,referenceRefs:refs,unusedRefs:[],modelscope:{nativeModelscope:marker,model:'test/mock_model',loras:{'test/main_style':0.75,'test/detail_style':0.25},count:8,size:'641x1279',referenceAssetIds:refs.map(r=>r.assetId)}},childRequests:{kind:'modelscope',count:8,attempted:7,submitted:6,completed:2,items}};
const plans=Array.from({length:8},(_,i)=>({title:'Mock 第'+(i+1)+'组 '+evil,cascadeKind:'generate',count:i+1,studio:{mode:'image',config:{protocol:'modelscope',nativeModelscope:marker,model:'test/mock_model',loras:{},count:i+1,size:'641x1279'}}}));
const plan={summary:{operations:8,generations:8,requests:36,sharedCopies:0},program:{},steps:plans};
const single={actualInput:{referenceRefs:[],unusedRefs:[],modelscope:{nativeModelscope:{version:1,modelKey:'zimage',acceptsImages:false},count:1,size:'1024x1024',referenceAssetIds:[]}},childRequests:{kind:'modelscope',count:1,attempted:1,submitted:1,completed:1,items:[{index:0,status:'completed',upstreamId:'mock-single-original'}]}};
window.fixtureData={actual,plan,single};window.originalState=JSON.stringify(window.fixtureData);
document.querySelector('#plan').innerHTML=nativeCascadePlanMarkup(plan,esc);document.querySelector('#actual').innerHTML=nativeCascadeRequestMarkup(actual,esc);document.querySelector('#single').innerHTML=nativeCascadeRequestMarkup(single,esc);
window.limits=plans.map(p=>({count:studioRequestCount(p.studio),references:studioModelscopeReferenceLimit(p.studio)}));
window.selectView=id=>{for(const e of document.querySelectorAll('#receipt-scroll>section'))e.hidden=e.id!==id;document.querySelector('#receipt-scroll').scrollTop=0;if(!document.querySelector('#fixture').open)document.querySelector('#fixture').showModal();};
for(const b of document.querySelectorAll('[data-view]'))b.addEventListener('click',()=>window.selectView(b.dataset.view));document.querySelector('#reopen').onclick=()=>window.selectView('actual');window.selectView('plan');window.ready=true;
</script></html>`;
const server=http.createServer((req,res)=>{if(req.method!=='GET'){res.writeHead(405);return res.end();}if(req.url==='/'){res.setHeader('content-type','text/html');return res.end(html);}const blob=sources.get(req.url);if(blob){res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');return res.end(blob);}res.writeHead(404);res.end();});
server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
let browser,page;const errors=[],blocked=[],requests=[],checks=[],widths=[];
const check=name=>checks.push(name);
try{
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-gpu','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:1280,height:960},serviceWorkers:'block'});
 await context.route('**/*',route=>{const r=route.request();requests.push({url:r.url(),method:r.method()});if(new URL(r.url()).origin!==base||r.method()!=='GET'){blocked.push(r.url());return route.abort();}return route.continue();});
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.waitForFunction(()=>window.ready);
 const choose=async id=>page.locator('[data-view="'+id+'"]').click();
 const toggle=async selector=>{await page.locator(selector).focus();await page.keyboard.press('Enter');};
 const fit=async label=>{const size=await page.evaluate(()=>({pageWidth:innerWidth,documentWidth:document.documentElement.scrollWidth,clientWidth:document.querySelector('#receipt-scroll').clientWidth,scrollWidth:document.querySelector('#receipt-scroll').scrollWidth}));widths.push({label,...size});assert(size.documentWidth<=size.pageWidth,label+' page overflow');assert(size.scrollWidth<=size.clientWidth+1,label+' dialog overflow');};
 const safe=async()=>{assert.equal(await page.locator('#receipt-scroll img,#receipt-scroll script,#receipt-scroll svg').count(),0);assert.equal(await page.evaluate(()=>window.mockXss),undefined);};
 assert.match(await page.locator('.dialog-head').innerText(),/Mock[\s\S]*合成/);check('visible-Mock-label-and-no-real-generation-claim');
 const limits=await page.evaluate(()=>window.limits);assert.deepEqual(limits.map(r=>r.count),[1,2,3,4,5,6,7,8]);assert(limits.every(r=>r.references===20));check('production-core-counts-one-through-eight-and-twenty-reference-limit');
 const summaries=await page.locator('#plan .native-modelscope-receipt>summary').allTextContents();assert.equal(summaries.length,8);summaries.forEach((s,i)=>assert.match(s,new RegExp('最多 '+(i+1)+' 次独立请求')));assert(summaries.every(s=>s.includes('641x1279')));check('all-eight-count-previews-show-exact-dimensions-and-independent-request-count');
 await safe();await fit('desktop-plan');await page.screenshot({path:path.join(stage,'01-mock-plan-desktop.png')});
 await choose('actual');await toggle('#actual>.native-cascade-request>summary');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.parentElement.className),'native-modelscope-receipt');await page.keyboard.press('Space');assert(await page.locator('#actual .native-modelscope-receipt').evaluate(e=>e.open));check('keyboard-Enter-Tab-Space-opens-real-nested-receipts');
 const receipt=await page.locator('#actual').innerText();assert.match(receipt,/已尝试 7 \/ 8 次 · 已接受 6 \/ 8 次 · 已完成 2 \/ 8 份/);assert.match(receipt,/实际使用 20 张参考图/);assert.equal(await page.locator('#actual .native-modelscope-receipt li').count(),8);assert.equal(await page.locator('#actual .native-modelscope-receipt li').filter({hasText:'原编号'}).count(),6);assert.match(receipt,/第 7 份 · 已停止，需核对原任务 · 未收到可查询编号/);assert.match(receipt,/第 8 份 · 未提交 · 未收到可查询编号/);check('actual-attempts-accepted-completed-and-eight-original-item-states-remain-distinct');
 assert.match(receipt,/模型 test\/mock_model/);assert.match(receipt,/test\/main_style × 0.75/);assert.match(receipt,/test\/detail_style × 0.25/);check('actual-model-and-LoRA-identities-and-weights-disclosed');
 await safe();check('title-prompt-and-reference-markup-escaped-without-execution');await fit('desktop-actual');await page.screenshot({path:path.join(stage,'02-mock-receipt-desktop.png')});
 await page.keyboard.press('Escape');assert.equal(await page.locator('#fixture').evaluate(e=>e.open),false);await page.setViewportSize({width:390,height:844});await page.locator('#reopen').focus();await page.keyboard.press('Enter');await fit('390-actual');await page.screenshot({path:path.join(stage,'03-mock-receipt-390.png')});check('390-open-after-resize-preserves-readable-actual-receipt-without-horizontal-overflow');
 await page.locator('#receipt-scroll').hover();await page.mouse.wheel(0,100000);await page.waitForFunction(()=>{const e=document.querySelector('#receipt-scroll');return e.scrollTop>=e.scrollHeight-e.clientHeight-2;});assert(await page.locator('#actual>details>ul>li').last().evaluate(e=>{const r=e.getBoundingClientRect(),b=document.querySelector('#receipt-scroll').getBoundingClientRect();return r.bottom>b.top&&r.top<b.bottom;}));await fit('390-reference-bottom');await page.screenshot({path:path.join(stage,'04-mock-references-390.png')});check('phone-scroll-reaches-twentieth-reference-without-dropping-or-mutation');
 await choose('single');await toggle('#single>.native-cascade-request>summary');await toggle('#single .native-modelscope-receipt>summary');const singleText=await page.locator('#single').innerText();assert.match(singleText,/实际使用 0 张参考图/);assert.match(singleText,/已尝试 1 \/ 1 次 · 已接受 1 \/ 1 次 · 已完成 1 \/ 1 份/);assert.match(singleText,/mock-single-original/);await fit('390-single');check('single-text-to-image-shows-zero-reference-one-original-request');
 assert.match(singleText,/LoRA 旧收据未单列，请核对原绑定/);assert(!singleText.includes('LoRA 未使用'));check('older-receipt-does-not-invent-absence-of-LoRA');
 const prior=await page.locator('#single').innerText();await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('#single').innerText(),prior);const durations=await page.locator('[data-view]').evaluateAll(es=>es.map(e=>getComputedStyle(e).transitionDuration));assert(durations.every(v=>v.split(',').every(n=>parseFloat(n)<=0.01)));await toggle('#single .native-modelscope-receipt>summary');await toggle('#single .native-modelscope-receipt>summary');await fit('390-reduced-motion');await page.screenshot({path:path.join(stage,'05-mock-reduced-motion-390.png')});check('reduced-motion-preserves-data-and-native-keyboard-details');
 assert.equal(await page.evaluate(()=>JSON.stringify(window.fixtureData)===window.originalState),true);assert.equal(await page.locator('#receipt-scroll button').count(),0);check('read-only-details-never-mutate-receipt-or-offer-resubmit');
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert(requests.every(r=>r.method==='GET'&&new URL(r.url).origin===base));check('only-isolated-GET-no-pageerror-provider-or-formal-write');
 const after=await Promise.all(names.map(async name=>({path:'public/'+name,sha256:hash(await fs.readFile(path.join(root,'public',name)))})));await fs.writeFile(path.join(stage,'source-end.json'),JSON.stringify(after,null,2));assert.deepEqual(after,before);check('production-source-and-five-styles-unchanged-during-check');
 const result={ok:true,evidenceKind:'mock_interaction',checks,widths,sourceUnchanged:true,pageErrors:errors,blocked,requests,realSecretsRead:0,externalProviderRequests:0,formalWrites:0,paidCalls:0,realPhoneOrGpu:false};await fs.writeFile(path.join(stage,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:true,passed:checks.length,stage}));
}catch(error){await fs.writeFile(path.join(stage,'failure.json'),JSON.stringify({ok:false,error:error.message,checks,widths,pageErrors:errors,blocked,requests},null,2));await page?.screenshot({path:path.join(stage,'failure-screen.png')}).catch(()=>{});throw error;}
finally{await browser?.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
