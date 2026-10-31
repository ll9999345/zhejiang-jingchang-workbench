import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createCanvas} from '@napi-rs/canvas';
import {localServer,waitFile} from './helpers/library-backup-server.mjs';
import {modelGlb} from './helpers/model3d-fixture.mjs';

const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const v2='/Users/mjd-ppps/生视频/浙江文旅AI视频引擎V2';
const stage=path.resolve(process.env.NATIVE_LIQUID_EVIDENCE||path.join(process.cwd(),'artifacts','native-liquid-browser-'+Date.now()));
const data=path.join(stage,'isolated-data'),checks=[],errors=[],outside=[],contrasts=[],firstFrames=[];
const focused=process.env.NATIVE_LIQUID_FOCUS==='references';
await fs.mkdir(path.join(stage,'screenshots'),{recursive:true});
let app,mount,browser,page;
const check=name=>checks.push(name),shot=name=>page.screenshot({path:path.join(stage,'screenshots',name+'.png')});
async function stopMount(){if(!mount||mount.exitCode!==null||mount.signalCode!==null)return;const done=once(mount,'exit');mount.kill('SIGTERM');await done;}
async function colors(selectors){
 const samples=await page.evaluate(selectors=>{
  const rgb=v=>(v.match(/[\d.]+/g)||[]).map(Number);
  const blend=(fg,bg)=>{const a=fg[3]??1;return fg.slice(0,3).map((v,i)=>v*a+bg[i]*(1-a));};
  const lum=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
  return selectors.map(selector=>{const el=document.querySelector(selector);if(!el)return {selector,missing:true};const style=getComputedStyle(el);let chain=[],node=el;while(node){chain.unshift(rgb(getComputedStyle(node).backgroundColor));node=node.parentElement;}let bg=[16,14,32];for(const layer of chain)if(layer.length>=3)bg=blend(layer,bg);const foreground=blend(rgb(style.color),bg),a=lum(foreground),b=lum(bg);return {selector,color:style.color,background:style.backgroundColor,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),colorScheme:style.colorScheme};});
 },selectors);
 for(const sample of samples){assert.equal(sample.missing,undefined,'missing '+sample.selector);assert.ok(sample.ratio>=4.5,JSON.stringify(sample));}contrasts.push({url:page.url(),samples});
}
async function darkEntry(url,label){
 await page.goto(url,{waitUntil:'domcontentloaded'});await page.locator('.jc-aurora').waitFor();
 await page.waitForFunction(()=>window.__themeFrames?.length>=4);
 assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 const early=await page.evaluate(()=>({frames:window.__themeFrames,writes:window.__themeWrites}));
 assert.deepEqual(early.writes,[]);for(const frame of early.frames){if(!frame.background||frame.background==='rgba(0, 0, 0, 0)')continue;assert.equal(frame.theme,'dark');assert.doesNotMatch(frame.background,/^rgb\(2(?:[4-5]\d), 2(?:[4-5]\d), 2(?:[4-5]\d)\)$/,'white first frame');}firstFrames.push({label,...early});
 await page.locator('body').evaluate(el=>{if(el.querySelector('.studio')){const s=el.querySelector('.studio');if(s.dataset.theme!=='dark')throw Error('studio overrode the root theme');}});
 check(label+' starts dark in a fresh light-OS browser without preference writes');
}
try{
 app=await localServer(data);
 const bitmap=createCanvas(96,64),ctx=bitmap.getContext('2d');ctx.fillStyle='#7786bc';ctx.fillRect(0,0,96,64);const png=bitmap.toBuffer('image/png');
 const upload=async(name,type,bytes)=>{const response=await fetch(app.base+'/api/assets?name='+encodeURIComponent(name),{method:'POST',headers:{'Content-Type':type},body:bytes});assert.ok(response.ok);return response.json();};
 const image=await upload('蓝紫参考.png','image/png',png),model=await upload('本机测试.glb','model/gltf-binary',modelGlb());
 let project=await app.api('/api/projects','POST',{name:'原生液态隔离验收'});project=await app.api('/api/projects/'+project.id,'PUT',{...project,assets:[image,model]});
 let studio=await app.api('/api/studios','POST',{name:'创作台主题隔离验收',projectId:project.id,mode:'video'});studio=await app.api('/api/studios/'+studio.id,'PUT',{...studio,prompt:'宁静湖面，镜头缓缓推进',references:[{assetId:image.id}],config:{...studio.config,protocol:'ark',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',model:'doubao-seedance-2-0-260128',arkReferenceMode:'multimodal'}});
 const mountedStage=path.join(stage,'mount');await fs.mkdir(mountedStage,{recursive:true});
 mount=spawn(path.join(v2,'.venv/bin/python'),['web_api/tests/helpers/native_cascade_mount.py','--engine-port',new URL(app.base).port,'--evidence',mountedStage],{cwd:v2,stdio:['ignore','pipe','pipe']});
 let mountLog='';for(const output of [mount.stdout,mount.stderr])output.on('data',chunk=>{mountLog+=chunk;});
 await waitFile(path.join(mountedStage,'mounted-fixture.json'));const mounted=JSON.parse(await fs.readFile(path.join(mountedStage,'mounted-fixture.json'),'utf8'));
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox','--disable-gpu']});
 const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'light'});
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(['127.0.0.1','localhost','[::1]'].includes(url.hostname)||['data:','blob:'].includes(url.protocol))return route.continue();outside.push(url.origin);return route.abort();});
 await context.addInitScript(()=>{window.__themeFrames=[];window.__themeWrites=[];const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(['backlot.theme','jingchang.theme.v1'].includes(key))window.__themeWrites.push({key,value});return original.call(this,key,value);};let remaining=12;function sample(){window.__themeFrames.push({theme:document.documentElement?.dataset.theme,background:document.body?getComputedStyle(document.body).backgroundColor:null,studio:document.querySelector('.studio')?.dataset.theme});if(--remaining>0)requestAnimationFrame(sample);}requestAnimationFrame(sample);});
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const pages=[['index','/?project='+project.id],['cloud-workflows','/cloud-workflows.html?project='+project.id],['creation-studio','/creation-studio.html?project='+studio.id],['conversation','/conversation.html?project='+project.id],['loras','/loras.html?project='+project.id],['model3d','/model3d.html?asset='+model.id+'&project='+project.id]];
 if(!focused){
  for(const [name,url]of pages){await darkEntry(app.base+url,'native '+name);await shot('native-'+name+'-desktop');}
  for(const [name,url]of pages){const mountedUrl=name==='index'?'/canvas?project='+project.id:'/canvas-module'+url;await darkEntry(mounted.base+mountedUrl,'mounted '+name);assert.equal(await page.locator('.jc-aurora').count(),1);await page.locator('.unified-navigation').waitFor();assert.ok((await page.locator('.unified-navigation a').first().getAttribute('href')).endsWith('/'));await shot('mounted-'+name+'-desktop');}
 }
 for(const width of focused?[390]:[1440,390]){
  await page.setViewportSize({width,height:width===390?844:1000});await page.goto(mounted.base+'/canvas-module/cloud-workflows.html?project='+project.id);await page.locator('main:not([inert])').waitFor();await colors(['h1','main>section>p','#name','#kind','#run']);await page.locator('#kind').selectOption('model');await page.locator('#model-panel:not([hidden])').waitFor();await colors(['#model-search','#model-select','#model-note','#kind option']);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('cloud-model-'+width);check('cloud model fields and native option styles remain readable at '+width+'px');
  await page.goto(mounted.base+'/canvas-module/creation-studio.html?project='+studio.id);await page.waitForFunction(()=>document.querySelector('#save-indicator')?.textContent==='已保存到本机工作区');
  // The user can select reference editing through the list on both screen widths.
  await page.locator('#view-list').click();await page.locator('[data-list-node=references]').click();await page.locator('#reference-url').scrollIntoViewIfNeeded();await page.locator('#reference-url-type').click();await page.keyboard.press('Escape');await colors(['#inspector-heading','#ref-drop strong','#reference-url','#reference-url-type','#reference-url-type option']);await page.locator('#reference-url-type').selectOption('video/mp4');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const bounds=await page.locator('#reference-url-type').boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=(width===390?844:1000));await shot('studio-references-'+width);check('selected reference sidebar, URL input and type options are visible, clickable and readable at '+width+'px');
 }
 if(!focused){
 await page.setViewportSize({width:1440,height:1000});await page.goto(mounted.base+'/canvas?project='+project.id);await page.locator('.rail [data-action=settings]').click();await page.waitForFunction(()=>document.querySelector('#modal[open] h2')?.textContent==='工作区设置');await page.locator('#modal [data-action=api-settings]').click();await page.waitForFunction(()=>document.querySelector('#modal[open] h2')?.textContent==='API 平台与模型');await colors(['#modal h2','#modal .muted']);await shot('settings-desktop');await page.locator('#modal [data-action=close-modal]').click();await page.locator('#modal').waitFor({state:'hidden'});
 await page.locator('.tabs [data-view=assets]').click();await page.locator('[data-action=asset-catalog]').click();await page.locator('#asset-catalog-dialog[open]').waitFor();await colors(['#asset-catalog-dialog header strong','#asset-catalog-dialog .catalog-note']);await shot('asset-catalog-desktop');await page.locator('[data-catalog=close]').click();
 for(const [action,dialog,close,selectors]of [['ark-assets','.ark-assets-dialog','[data-ark=close]',['.ark-assets-dialog header strong','.ark-assets-dialog input']],['public-media','.public-media-dialog','[data-host=close]',['.public-media-dialog header strong','.public-media-dialog input']],['shared-folders','.shared-folders-dialog','[data-shared=close]',['.shared-folders-dialog header strong','.shared-folders-dialog input']]]){await page.locator('[data-action='+action+']').click();await page.locator(dialog+'[open]').waitFor();await colors(selectors);await shot(action+'-desktop');await page.locator(close).click();}check('settings and all asset dialogs follow the application theme on a light OS');
 // An explicit preference remains light; only the real toggle creates a preference write.
 await page.evaluate(()=>localStorage.setItem('backlot.theme','light'));await page.goto(mounted.base+'/canvas-module/creation-studio.html?project='+studio.id);await page.locator('#theme-toggle').waitFor();assert.equal(await page.locator('html').getAttribute('data-theme'),'light');assert.equal(await page.locator('.studio').getAttribute('data-theme'),'light');await colors(['#inspector-heading','#theme-toggle']);await page.locator('#theme-toggle').click();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');assert.equal(await page.evaluate(()=>localStorage.getItem('backlot.theme')),'dark');await page.goto(mounted.base+'/canvas-module/cloud-workflows.html?project='+project.id);assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');check('explicit stored light remains readable; a user toggle persists dark across feature pages');
 const nativeContext=await browser.newContext({viewport:{width:390,height:844},colorScheme:'light'});await nativeContext.addInitScript(()=>localStorage.setItem('jingchang.theme.v1','light'));const nativePage=await nativeContext.newPage();await nativePage.goto(app.base+'/cloud-workflows.html?project='+project.id);assert.equal(await nativePage.locator('html').getAttribute('data-theme'),'light');check('explicit native light is retained without clearing storage');await nativeContext.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
 await fs.writeFile(path.join(stage,'browser-result.json'),JSON.stringify({passed:true,checks,contrasts,firstFrames,errors,outsideRequests:outside,paidCalls:0,thirdPartyUploads:0,productionProjectsModified:false,isolatedData:data,frontendBuild:await page.evaluate(()=>window.JingchangTheme.version),browser:browser.version(),physicalPhone:false,renderer:'software Chrome; liquid CSS/poster/video fallback and available shared renderer',screenshots:await fs.readdir(path.join(stage,'screenshots'))},null,2));console.log(JSON.stringify({passed:true,checks:checks.length,stage}));
}catch(error){await page?.screenshot({path:path.join(stage,'screenshots','failure-'+Date.now()+'.png')}).catch(()=>{});await fs.writeFile(path.join(stage,'failure-'+Date.now()+'.json'),JSON.stringify({error:error.message,checks,contrasts,firstFrames,errors,outside},null,2));throw error;}
finally{await browser?.close();await stopMount();await app?.stop();}
